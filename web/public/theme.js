// Set the saved theme before the app paints.
try {
  const theme = localStorage.getItem("theme");
  if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
} catch {
  // The app uses the default theme when browser storage is unavailable.
}
