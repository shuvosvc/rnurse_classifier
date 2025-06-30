require("dotenv").config();

var ApplicationSettings = {
  port: process.env.PORT || 8080,
  jwtSecret: process.env.JWTSECRET || "fish",
 // Individual PostgreSQL settings
  postgresHost: process.env.POSTGRES_HOST || "localhost",
  postgresUser: process.env.POSTGRES_USER || "default",
  postgresPassword: process.env.POSTGRES_PASSWORD || "",
  postgresDatabase: process.env.POSTGRES_DATABASE || "mydatabase",
  connectionLimit: process.env.CONNECTION_LIMIT || 100,

};

module.exports = ApplicationSettings;
