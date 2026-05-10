export function shouldStopDedupe(result) {
  if (!result) return true;
  if (result.necessity?.necessary === false) return true;
  if (result.integrated !== true) return true;
  if (result.action === "keep" || result.action === "explain") return true;
  if (result.should_continue === false) return true;
  return false;
}
