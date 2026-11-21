const script = (process.env.DATABASE_ENGINE || "mysql") === "sqlite" ? "./database_setup_sqlite" : "./database_setup";

// The MySQL script runs when imported. The SQLite one runs only when started itself (so a test can import it): it is asked to here.
const loaded = await import(script);
if (typeof loaded.runSetup === "function") await loaded.runSetup();
