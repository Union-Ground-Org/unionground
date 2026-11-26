// A destructuring default is the same committed fallback in another shape.
const { INSTITUTIONAL_RECORDS_DB_URL = "postgresql://placeholder@127.0.0.1:1/x" } = process.env;
export const databaseUrl = INSTITUTIONAL_RECORDS_DB_URL;
