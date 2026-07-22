/** Pure/testable helpers shared by the recurring scanner. */

export function parseWorkdayPostedOn(postedOn) {
  if (!postedOn) return null;
  const value = String(postedOn).toLowerCase();
  if (value.includes('today')) return 0;
  if (value.includes('yesterday')) return 1;
  const match = value.match(/(\d+)\+?\s*days?\s*ago/);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Arm a response listener before navigation and await both together. This is
 * important because a failed navigation must still observe a later rejection
 * from waitForResponse instead of leaving an orphaned promise.
 */
export async function captureResponseDuringNavigation(
  page,
  predicate,
  responseOptions,
  targetUrl,
  navigationOptions,
) {
  const [response] = await Promise.all([
    page.waitForResponse(predicate, responseOptions),
    page.goto(targetUrl, navigationOptions),
  ]);
  return response;
}
