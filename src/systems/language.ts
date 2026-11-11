import log from "../modules/logger";
// The language service, a git submodule at src/language-service, runs in this process: its
// translator is a Python child process the engine starts (see that folder's README).
import { set_logger, start_translator, translate_text, TranslationRequestError } from "../language-service/src/api";

set_logger({ info: log.info, warn: log.warn, error: log.error });

declare interface TranslationData {
    source_text: string;
    source_language: string;
    target_languages: string;
}

const language = {
    // The language service's calls, replaceable in tests.
    service: { translate_text, start_translator },

    /** Loads the translation model now, so the first chat line does not wait for it. */
    start: () => {
        language.service.start_translator().catch(() => {}); // the service logs why it could not start
    },

    translate: async (data: TranslationData) => {
        try {
            const result = await language.service.translate_text(data);
            // Only the requested language's own entry, and only plain text, goes on.
            const translations = result?.translated_text;
            const translated = translations && typeof translations === "object" && Object.hasOwn(translations, data.target_languages)
                ? translations[data.target_languages]
                : undefined;
            if (typeof translated !== "string" || translated === "") {
                log.error("No translation received from the language service");
                return data.source_text;
            }
            return translated;
        } catch (error) {
            // A request the service refuses (a language it does not know, a line too long) keeps the line as sent.
            if (error instanceof TranslationRequestError) {
                log.error(`Translation refused: ${error.message}`);
                return data.source_text;
            }
            log.error(`Translation failed: ${error}`);
        }
    },

    /**
     * One translation per language for a line, shared by every listener who reads that language: the first to ask
     * starts it and the rest wait on the same answer, so listeners asking at once do not each call the translator.
     */
    perLanguage: (translateTo: (target: string) => Promise<string>): ((target: string) => Promise<string>) => {
        // A Map: a listener's language comes from their client, and "__proto__" must not reach an object's prototype.
        const lines = new Map<string, Promise<string>>();
        return (target: string) => {
            let line = lines.get(target);
            if (!line) {
                line = translateTo(target);
                lines.set(target, line);
            }
            return line;
        };
    }
};

export default language;
