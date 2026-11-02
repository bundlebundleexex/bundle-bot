const MIN_RENEWAL_EXTENSION_MS = 20 * 60 * 60 * 1000;

function isSignificantExtension(previousEndAt, currentEndAt) {
  const previous = Date.parse(previousEndAt || "");
  const current = Date.parse(currentEndAt || "");
  return Number.isFinite(previous) && Number.isFinite(current) &&
    current >= previous + MIN_RENEWAL_EXTENSION_MS;
}

module.exports = { MIN_RENEWAL_EXTENSION_MS, isSignificantExtension };
