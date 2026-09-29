/** Imperial formatting for the info panel (inches to the nearest 1/16). */

function fraction(mm: number, denom: number): { whole: number; num: number; den: number } {
  const inch = mm / 25.4;
  let whole = Math.floor(inch);
  let num = Math.round((inch - whole) * denom);
  if (num === denom) {
    whole++;
    num = 0;
  }
  let den = denom;
  while (num && num % 2 === 0) {
    num /= 2;
    den /= 2;
  }
  return { whole, num, den };
}

/** "62 1/16" (no unit). */
export function inchValue(mm: number, denom = 16): string {
  const { whole, num, den } = fraction(mm, denom);
  if (!num) return String(whole);
  return whole ? `${whole} ${num}/${den}` : `${num}/${den}`;
}

/** "62 1/16 in". */
export function inches(mm: number, denom = 16): string {
  return `${inchValue(mm, denom)} in`;
}
