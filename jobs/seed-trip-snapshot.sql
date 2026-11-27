-- Databricks notebook source
SELECT assert_true(
  :catalog RLIKE '^[A-Za-z_][A-Za-z0-9_-]{0,127}$'
    AND :schema RLIKE '^[A-Za-z_][A-Za-z0-9_-]{0,127}$',
  'Expected valid catalog/schema identifiers.'
);

-- COMMAND ----------

DECLARE OR REPLACE VARIABLE pickup_start DATE DEFAULT try_cast(:snapshot_start_date AS DATE);

-- COMMAND ----------

DECLARE OR REPLACE VARIABLE pickup_end DATE DEFAULT try_cast(:snapshot_end_date AS DATE);

-- COMMAND ----------

SELECT assert_true(
  :snapshot_start_date RLIKE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND :snapshot_end_date RLIKE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND session.pickup_start >= DATE '0001-01-01'
    AND session.pickup_start <= session.pickup_end,
  'Expected a valid inclusive pickup date range in YYYY-MM-DD format.'
);

-- COMMAND ----------

DECLARE OR REPLACE VARIABLE trip_source_files ARRAY<STRING> DEFAULT transform(
  sequence(trunc(session.pickup_start, 'MONTH'), trunc(session.pickup_end, 'MONTH'), INTERVAL 1 MONTH),
  month_start -> 'yellow_tripdata_' || date_format(month_start, 'yyyy-MM') || '.csv.gz'
);

-- COMMAND ----------

CREATE TABLE IF NOT EXISTS IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`trips_raw`') (
  trip_id STRING NOT NULL,
  source_file STRING NOT NULL,
  VendorID INT,
  tpep_pickup_datetime TIMESTAMP_NTZ,
  tpep_dropoff_datetime TIMESTAMP_NTZ,
  passenger_count INT,
  trip_distance DOUBLE,
  pickup_longitude DOUBLE,
  pickup_latitude DOUBLE,
  RatecodeID INT,
  store_and_fwd_flag STRING,
  dropoff_longitude DOUBLE,
  dropoff_latitude DOUBLE,
  payment_type INT,
  fare_amount DOUBLE,
  extra DOUBLE,
  mta_tax DOUBLE,
  tip_amount DOUBLE,
  tolls_amount DOUBLE,
  improvement_surcharge DOUBLE,
  total_amount DOUBLE
) USING DELTA;

-- COMMAND ----------

BEGIN
  -- Copy before loading any files so existing trip comments keep their IDs.
  IF NOT EXISTS (
      SELECT 1 FROM IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`trips_raw`')
    ) AND EXISTS (
      SELECT 1 FROM IDENTIFIER('`' || :catalog || '`.information_schema.tables')
      WHERE table_schema = lower(:schema) AND table_name = 'trips_2016_raw'
    ) THEN
    INSERT INTO IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`trips_raw`') BY NAME
    SELECT * EXCEPT (analytics_valid, pickup_coordinates_valid, dropoff_coordinates_valid)
    FROM IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`trips_2016_raw`');
  END IF;
END;

-- COMMAND ----------

BEGIN
  DECLARE missing_files ARRAY<STRING>;
  DECLARE source_path STRING;

  SET missing_files = (
    SELECT array_except(session.trip_source_files, collect_set(source_file))
    FROM IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`trips_raw`')
    WHERE array_contains(session.trip_source_files, source_file)
  );

  IF size(missing_files) > 0 THEN
    SET source_path = '/Volumes/samples/databricks/datasets/nyctaxi/tripdata/yellow/'
      || CASE WHEN size(missing_files) = 1 THEN element_at(missing_files, 1)
         ELSE '{' || array_join(missing_files, ',') || '}' END;

    -- Each source file is immutable. Keep its UUIDs when later ranges reuse it.
    EXECUTE IMMEDIATE '
    INSERT INTO IDENTIFIER(:raw_table) BY NAME
    SELECT uuid() AS trip_id, _metadata.file_name AS source_file, source.*
    FROM read_files(
      :source_path,
      format => \'csv\', header => true, enforceSchema => false, mode => \'FAILFAST\',
      schema => \'VendorID INT, tpep_pickup_datetime TIMESTAMP_NTZ, tpep_dropoff_datetime TIMESTAMP_NTZ, passenger_count INT, trip_distance DOUBLE, pickup_longitude DOUBLE, pickup_latitude DOUBLE, RatecodeID INT, store_and_fwd_flag STRING, dropoff_longitude DOUBLE, dropoff_latitude DOUBLE, payment_type INT, fare_amount DOUBLE, extra DOUBLE, mta_tax DOUBLE, tip_amount DOUBLE, tolls_amount DOUBLE, improvement_surcharge DOUBLE, total_amount DOUBLE\'
    ) AS source
    ' USING source_path AS source_path,
      '`' || :catalog || '`.`' || :schema || '`.`trips_raw`' AS raw_table;
  END IF;
END;

-- COMMAND ----------

CREATE OR REPLACE TEMPORARY VIEW snapshot_source AS
SELECT source.*,
  coalesce(tpep_pickup_datetime >= CAST(session.pickup_start AS TIMESTAMP_NTZ)
    AND tpep_pickup_datetime < CAST(date_add(session.pickup_end, 1) AS TIMESTAMP_NTZ)
    AND tpep_dropoff_datetime > tpep_pickup_datetime
    AND tpep_dropoff_datetime <= tpep_pickup_datetime + INTERVAL 1 DAY
    AND trip_distance > 0 AND trip_distance < double('Infinity')
    AND fare_amount > 0 AND fare_amount < double('Infinity'), false) AS analytics_valid,
  coalesce(pickup_longitude BETWEEN -75 AND -72 AND pickup_latitude BETWEEN 40 AND 42, false) AS pickup_coordinates_valid,
  coalesce(dropoff_longitude BETWEEN -75 AND -72 AND dropoff_latitude BETWEEN 40 AND 42, false) AS dropoff_coordinates_valid
FROM IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`trips_raw`') AS source
WHERE array_contains(session.trip_source_files, source_file);

-- COMMAND ----------

SELECT assert_true(
  COUNT(DISTINCT source_file) = size(session.trip_source_files),
  'Expected a nonempty yellow taxi CSV for every month in the pickup date range.'
), assert_true(
  count_if(analytics_valid) > 0 AND count_if(analytics_valid) = COUNT(DISTINCT trip_id) FILTER (WHERE analytics_valid),
  'Expected at least one accepted trip in the pickup date range and unique trip IDs.'
)
FROM snapshot_source;

-- COMMAND ----------

-- Grid candidates bound spatial work. ST_Covers tests original GPS points
-- against complete ZCTA polygons; shared-edge matches choose the lowest ZIP.
CREATE TABLE IF NOT EXISTS IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`taxi_zip_cells`') USING DELTA AS
SELECT zip, ST_AsBinary(ST_GeomFromGeoJSON(geometry)) AS boundary_wkb, lon_bin, lat_bin
FROM read_files(
  '/Volumes/' || :catalog || '/' || :schema || '/taxi_sources/nyc-zcta.jsonl',
  format => 'json',
  schema => 'zip STRING, geometry STRING, min_x DOUBLE, max_x DOUBLE, min_y DOUBLE, max_y DOUBLE'
) AS z,
LATERAL explode(sequence(CAST(floor(min_x * 100) AS INT), CAST(floor(max_x * 100) AS INT))) AS x(lon_bin),
LATERAL explode(sequence(CAST(floor(min_y * 100) AS INT), CAST(floor(max_y * 100) AS INT))) AS y(lat_bin);

-- COMMAND ----------

CREATE OR REPLACE TABLE IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`trip_locations`')
USING DELTA AS
WITH locations AS (
  SELECT pickup_longitude AS longitude, pickup_latitude AS latitude
  FROM snapshot_source WHERE analytics_valid AND pickup_coordinates_valid
  UNION
  SELECT dropoff_longitude, dropoff_latitude
  FROM snapshot_source WHERE analytics_valid AND dropoff_coordinates_valid
)
SELECT /*+ BROADCAST(z) */ longitude, latitude, MIN(z.zip) AS zip
FROM locations AS p
LEFT JOIN IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`taxi_zip_cells`') AS z
  ON CAST(floor(p.longitude * 100) AS INT) = z.lon_bin
  AND CAST(floor(p.latitude * 100) AS INT) = z.lat_bin
  AND ST_Covers(ST_GeomFromWKB(z.boundary_wkb, 4326), ST_Point(p.longitude, p.latitude, 4326))
GROUP BY longitude, latitude;

-- COMMAND ----------

CREATE OR REPLACE TABLE IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`trips`')
USING DELTA
CLUSTER BY (tpep_pickup_datetime, pickup_zip)
TBLPROPERTIES ('delta.feature.timestampNtz' = 'supported') AS
SELECT q.*, p.zip AS pickup_zip, d.zip AS dropoff_zip
FROM snapshot_source AS q
LEFT JOIN IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`trip_locations`') AS p
  ON q.pickup_coordinates_valid AND q.pickup_longitude = p.longitude AND q.pickup_latitude = p.latitude
LEFT JOIN IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`trip_locations`') AS d
  ON q.dropoff_coordinates_valid AND q.dropoff_longitude = d.longitude AND q.dropoff_latitude = d.latitude
WHERE q.analytics_valid;

-- COMMAND ----------

CREATE TABLE IF NOT EXISTS IDENTIFIER('`' || :catalog || '`.`' || :schema || '`.`route_reliability_runs`') (
  run_id BIGINT NOT NULL,
  report_json STRING NOT NULL
) USING DELTA;

-- COMMAND ----------

SELECT source_file, COUNT(*) AS raw_trips,
  count_if(analytics_valid) AS accepted_trips,
  count_if(NOT analytics_valid) AS rejected_trips,
  count_if(analytics_valid AND NOT pickup_coordinates_valid) AS accepted_without_pickup_gps,
  count_if(analytics_valid AND NOT dropoff_coordinates_valid) AS accepted_without_dropoff_gps
FROM snapshot_source
GROUP BY source_file
ORDER BY source_file;
