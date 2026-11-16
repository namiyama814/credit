if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(registration => {
      // Apply updates on the next request; never reload an answer in progress.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void registration.update().catch(() => {});
      });
    }).catch(() => {
      // A blocked worker must not prevent ordinary online study.
    });
  });
}
