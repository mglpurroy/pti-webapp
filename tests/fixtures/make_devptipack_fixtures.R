# Export devPTIpack reference results for the JS parity tests
# (tests/devptipack.parity.test.js).
#
# Runs devPTIpack's own calculation functions on its bundled Rwanda and
# Ukraine samples for a few weighting schemes, and writes the inputs and
# PTI scores per admin level to tests/fixtures/devptipack_<tag>.json.
#
# Weights are kept to -1/0/+1: in devPTIpack the weight is applied before
# z-score standardisation, so only its sign affects the result (see
# docs/METHODOLOGY.md, "Differences from the devPTIpack code").
#
# Usage (from the repo root, with a local clone of worldbank/devPTIpack):
#   Rscript tests/fixtures/make_devptipack_fixtures.R <path to devPTIpack>
suppressPackageStartupMessages({
  library(dplyr); library(purrr); library(tidyr); library(stringr)
  library(tibble); library(sf); library(magrittr); library(rlang); library(jsonlite)
})
get_golem_options <- function(x) NULL   # golem is only used for an option lookup

pkg <- commandArgs(TRUE)[1]
out_dir <- "tests/fixtures"
source(file.path(pkg, "R", "calc_pti_helpers.R"))
source(file.path(pkg, "R", "calc_pti_expander.R"))
pkg_rev <- system(paste("git -C", shQuote(pkg), "rev-parse --short HEAD"), intern = TRUE)

pcod_cols <- function(df) names(df)[str_detect(names(df), "^admin[0-9]+Pcod$")]

export <- function(tag, mtdt, shp) {
  ind  <- mtdt$metadata %>% filter(!fltr_exclude_pti) %>% select(var_code, var_name, spatial_level)
  long <- pivot_pti_dta(mtdt, ind)
  mt   <- get_mt(shp)
  ex   <- clean_geoms(shp)
  v <- ind$var_code; n <- length(v)
  schemes <- list(
    all_plus    = rep(1, n),
    alternating = rep(c(1, -1), length.out = n),
    first_only  = c(1, rep(0, n - 1)),
    mixed       = rep(c(-1, 0, 1), length.out = n)
  )
  res <- imap(schemes, function(w, nm) {
    wl <- set_names(list(tibble(var_code = v, weight = w)), nm)
    base <- get_weighted_data(wl, long, ind) %>% get_scores_data() %>%
      imap(~ expand_adm_levels(.x, mt) %>% merge_expandedn_adm_levels())
    keep <- function(x) map(x, ~ .x %>% select(all_of(pcod_cols(.x)), pti_score))
    list(weights = as.list(set_names(w, v)),
         na_keep = keep(agg_pti_scores(base, ex, na_rm_pti2 = FALSE)),
         na_rm   = keep(agg_pti_scores(base, ex, na_rm_pti2 = TRUE)))
  })
  sheets <- names(mtdt)[str_detect(names(mtdt), "^admin[0-9]")]
  data <- map(set_names(sheets), ~ mtdt[[.x]] %>% select(all_of(pcod_cols(mtdt[[.x]])), any_of(v)))
  fx <- list(source = paste0("worldbank/devPTIpack@", pkg_rev, " sample ", tag),
             indicators = ind, mapping = mt, data = data, results = res)
  write_json(fx, file.path(out_dir, paste0("devptipack_", tag, ".json")),
             digits = NA, na = "null", auto_unbox = TRUE)
  cat(tag, ": levels", paste(names(ex), collapse = ","), "| sheets", paste(sheets, collapse = ","),
      "| vars", paste(v, collapse = ","), "| mapping rows", nrow(mt), "\n")
}

e <- new.env()
load(file.path(pkg, "data", "rwa_mtdt_full.rda"), e); load(file.path(pkg, "data", "rwa_shp.rda"), e)
export("rwa", e$rwa_mtdt_full, e$rwa_shp)
load(file.path(pkg, "data", "ukr_mtdt_full.rda"), e); load(file.path(pkg, "data", "ukr_shp.rda"), e)
export("ukr", e$ukr_mtdt_full, e$ukr_shp)
