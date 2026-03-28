function normalizeConcurrency(value, fallback = 1) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.floor(value));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const normalizedConcurrency = Math.min(items.length || 1, normalizeConcurrency(concurrency, 1));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      if (currentIndex >= items.length) {
        return;
      }
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: normalizedConcurrency }, () => runWorker()));
  return results;
}

module.exports = {
  normalizeConcurrency,
  mapWithConcurrency
};
