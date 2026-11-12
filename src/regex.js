// ES-module access to the regex checks also used by the self-contained page reader.
import './status-core.js';

export const { compileRegex, regexSubject, MAX_PATTERN_LENGTH, MAX_REGEX_INPUT } = globalThis.TabkeeperStatusCore;
