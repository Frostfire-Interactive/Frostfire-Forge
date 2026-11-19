// Entry of `bun setup`: sets the schema up for the engine in DATABASE_ENGINE. The SQLite script for
// "sqlite", the MySQL script (also used for MariaDB) for anything else. Each script ends the process.
const script = (process.env.DATABASE_ENGINE || "mysql") === "sqlite" ? "./database_setup_sqlite" : "./database_setup";

// The MySQL script runs when imported. The SQLite one runs only when started itself (so a test can import it): it is asked to here.
const loaded = await import(script);
if (typeof loaded.runSetup === "function") await loaded.runSetup();
