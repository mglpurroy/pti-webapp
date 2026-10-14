# devPTIpack sample bundle

`metadata.xlsx` is `inst/sample_pti/app-data/sample-metadata.xlsx` from [worldbank/devPTIpack](https://github.com/worldbank/devPTIpack) (commit `32ffa79`). `shapefiles.zip` is `sample-shapes.rds` from the same folder, written as one GeoJSON per admin layer, the format `compile_pti_data()` produces.

It is the package's synthetic Ukraine test set: nine indicators placed at different combinations of oblast, rayon and hexagon levels, with missing values. The importer test (`tests/import.test.js`) loads it and checks the PTI against devPTIpack's own results.

```bash
python prep/import_devptipack.py prep/examples/devptipack_sample/metadata.xlsx \
       prep/examples/devptipack_sample/shapefiles.zip --id ukr_sample
```

devPTIpack is © World Bank, released under the MIT License with the World Bank IGO rider.
