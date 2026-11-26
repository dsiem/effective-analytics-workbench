-- Databricks notebook source
SELECT assert_true(
  :catalog RLIKE '^[A-Za-z_][A-Za-z0-9_-]{0,127}$'
    AND :schema RLIKE '^[A-Za-z_][A-Za-z0-9_-]{0,127}$'
    AND :app_service_principal_id RLIKE '(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  'Expected valid catalog/schema identifiers and the Databricks App principal UUID.'
);

-- COMMAND ----------

BEGIN
  DECLARE grant_sql STRING;
  SET grant_sql = 'GRANT USE CATALOG ON CATALOG `' || :catalog || '` TO `' || :app_service_principal_id || '`';
  EXECUTE IMMEDIATE grant_sql;
  SET grant_sql = 'GRANT USE SCHEMA ON SCHEMA `' || :catalog || '`.`' || :schema || '` TO `' || :app_service_principal_id || '`';
  EXECUTE IMMEDIATE grant_sql;
  SET grant_sql = 'GRANT SELECT ON TABLE `' || :catalog || '`.`' || :schema || '`.`trips` TO `' || :app_service_principal_id || '`';
  EXECUTE IMMEDIATE grant_sql;
  SET grant_sql = 'GRANT SELECT ON TABLE `' || :catalog || '`.`' || :schema || '`.`route_reliability_runs` TO `' || :app_service_principal_id || '`';
  EXECUTE IMMEDIATE grant_sql;
END;
