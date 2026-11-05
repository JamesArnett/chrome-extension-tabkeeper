// Worker-side wrapper around chrome.scripting for Feature B. Injects the
// self-contained reader into all frames of a tab and picks the best frame.

export const READER_FILES = ['src/status-core.js', 'src/reader.js'];

/** Prefer the frame with most values; on a total miss, the one that matched most elements. */
export function pickBestFrame(frames) {
  let best = null;
  for (const f of frames ?? []) {
    const r = f?.result;
    if (!r || !Array.isArray(r.results)) continue;
    if (
      !best ||
      r.valueCount > best.valueCount ||
      (r.valueCount === best.valueCount && r.matchedTotal > best.matchedTotal)
    ) {
      best = r;
    }
  }
  return best;
}

export function createStatusReader({ scripting, permissions, logger = console }) {
  return {
    async hasAccess(origin) {
      if (!origin) return false;
      try {
        return await permissions.contains({ origins: [`${origin}/*`] });
      } catch {
        return false;
      }
    },

    /** Resolves to the best frame's { results, matchedTotal, valueCount, complete } or null. */
    async read(tabId, fields, { timeoutMs, watch, lastStatus }) {
      try {
        await scripting.executeScript({ target: { tabId, allFrames: true }, files: READER_FILES });
        const frames = await scripting.executeScript({
          target: { tabId, allFrames: true },
          // Must be self-contained: only touches globals defined by the injected files.
          func: (payload) => globalThis.TabkeeperReader.read(payload),
          args: [{ fields, timeoutMs, watch, lastStatus }],
        });
        return pickBestFrame(frames);
      } catch (err) {
        logger.warn('[tabkeeper] could not read page in tab', tabId, err?.message ?? err);
        return null;
      }
    },
  };
}
