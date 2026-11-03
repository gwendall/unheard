// The flight archive's address, one setting read at build time. Empty or unset: not connected, so
// the where page offers no search. In development the page falls back on
// the local tiles of app/dev-history; an empty setting still means not connected, to see that state.

const SETTING = process.env.NEXT_PUBLIC_HISTORY_URL;

/** Where the where page reads its tiles, or "" for none. */
export const ARCHIVE_URL = SETTING ?? (process.env.NODE_ENV === "development" ? "/dev-history" : "");
