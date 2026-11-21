import log from "../modules/logger";

export function deferredStep(what: string, run: () => Promise<void>, onFail?: () => void): () => void {
  return () => {
    run().catch((error) => {
      log.error(`${what} could not be finished: ${error}`);
      try {
        onFail?.();
      } catch (failure) {
        log.error(`${what}: the clean-up after the failure failed too: ${failure}`);
      }
    });
  };
}
