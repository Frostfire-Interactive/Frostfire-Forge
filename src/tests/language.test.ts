import { afterEach, expect, test } from "bun:test";
import language from "../systems/language";
import { TranslationRequestError, translate_text } from "../language-service/src/api";

const realService = { ...language.service };
afterEach(() => {
  language.service = { ...realService };
});

// The language service answers with this, standing in for the translator.
function answer(body: unknown, seen: unknown[] = []) {
  language.service.translate_text = (async (request: unknown) => {
    seen.push(request);
    return body;
  }) as unknown as typeof translate_text;
  return seen;
}

test("language.translate asks the language service for the line and its languages", async () => {
  // The service's own answer, as it logs it.
  const seen = answer({ source_language: "en", target_languages: ["es"], source_text: "Hello & bye", translated_text: { es: "Hola & adios" }, translation_time: "8.57ms" });
  const result = await language.translate({ source_text: "Hello & bye", source_language: "en", target_languages: "es" });
  expect(result).toBe("Hola & adios");
  expect(seen).toEqual([{ source_text: "Hello & bye", source_language: "en", target_languages: "es" }]);
});

test("language.translate gives the line back when the service sends no translation", async () => {
  for (const body of [{ translated_text: { fr: "" } }, { translated_text: {} }, { translated_text: { es: "Hola." } }]) {
    answer(body);
    const result = await language.translate({ source_text: "Hello", source_language: "en", target_languages: "fr" });
    expect(result).toBe("Hello");
  }
});

test("language.translate takes only plain text from the service", async () => {
  const line = { source_text: "Hello", source_language: "en", target_languages: "es" };
  for (const body of [
    { translated_text: { es: { toString: "<img src=x onerror=alert(1)>" } } },
    { translated_text: { es: ["<script>alert(1)</script>"] } },
    { translated_text: { es: 42 } },
    { translated_text: { es: null } },
    { translated_text: "<script>alert(1)</script>" },
    { translated_text: ["<script>alert(1)</script>"] },
    { translated_text: null },
    {},
    null,
    "<script>alert(1)</script>",
  ]) {
    answer(body);
    expect(await language.translate(line)).toBe("Hello");
  }
});

test("language.translate reads only the answer's own entry for a language", async () => {
  answer({ translated_text: { es: "Hola." } });
  for (const target of ["constructor", "__proto__", "toString"]) {
    expect(await language.translate({ source_text: "Hello", source_language: "en", target_languages: target })).toBe("Hello");
  }
});

test("language.translate gives the line back when the service refuses the request", async () => {
  language.service.translate_text = async () => {
    throw new TranslationRequestError("Invalid target language");
  };
  const result = await language.translate({ source_text: "Hello", source_language: "en", target_languages: "es" });
  expect(result).toBe("Hello");
});

test("the language service refuses what it cannot translate before asking the translator", async () => {
  // The real service: these are refused before its translator (a Python process) is started.
  const line = { source_text: "Hello", source_language: "en", target_languages: "de" };
  await expect(translate_text(line)).rejects.toBeInstanceOf(TranslationRequestError);
  expect(await language.translate(line)).toBe("Hello");
  expect(await language.translate({ ...line, source_language: "de", target_languages: "es" })).toBe("Hello");
  expect(await language.translate({ ...line, source_text: "x".repeat(501), target_languages: "es" })).toBe("x".repeat(501));
});

test("language.perLanguage asks once per language, even when every listener asks at once", async () => {
  const asked: string[] = [];
  const lineFor = language.perLanguage(async (target) => {
    asked.push(target);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return `line in ${target}`;
  });
  // as the chat relay does it: every listener at the same time, none waiting for another
  const listeners = ["es", "es", "fr", "es", "fr", "de"];
  const lines = await Promise.all(listeners.map((target) => lineFor(target)));
  expect(asked.sort()).toEqual(["de", "es", "fr"]);
  expect(lines).toEqual(listeners.map((target) => `line in ${target}`));
  expect(await lineFor("es")).toBe("line in es");
  expect(asked).toHaveLength(3);
});

test("language.perLanguage keeps a language a listener sends as a plain key", async () => {
  const lineFor = language.perLanguage(async (target) => `line in ${target}`);
  expect(await lineFor("__proto__")).toBe("line in __proto__");
  expect(await lineFor("constructor")).toBe("line in constructor");
});

test("language.translate gives undefined when the translator cannot answer", async () => {
  language.service.translate_text = async () => {
    throw new Error("Translator stopped (exit code 1)");
  };
  const result = await language.translate({ source_text: "Hello", source_language: "en", target_languages: "es" });
  expect(result).toBeUndefined();
});

test("language.start loads the model without failing the boot when the translator cannot start", async () => {
  let started = 0;
  language.service.start_translator = async () => {
    started++;
    throw new Error("Translator could not start");
  };
  language.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toBe(1);
});
