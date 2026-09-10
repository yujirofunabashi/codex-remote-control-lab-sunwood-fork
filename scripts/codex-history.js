// The phone displays at most 80 history entries. A full resume/read includes
// tool output and embedded images it never displays and can exceed 100 MB.
// Ask Codex for recent summaries instead; the saved transcript stays intact.
const recentTurnsOptions = Object.freeze({ limit: 80, sortDirection: "desc", itemsView: "summary" });

function withRecentTurns(thread, page) {
  if (!Array.isArray(page?.data)) throw new Error("Codex did not return the requested conversation history");
  return { ...thread, turns: [...page.data].reverse() };
}

module.exports = { recentTurnsOptions, withRecentTurns };
