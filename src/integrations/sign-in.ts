/**
 * Where a sign-in page sends people. Rohlík registers only loopback addresses for clients that register
 * themselves, so the browser ends on an error page at this address, and the person pastes the address into Golem,
 * which reads the sign-in code from it.
 */
export const SIGN_IN_ADDRESS = "https://localhost/golem-sign-in";
/** The step of a guide that ends a sign-in at `address`. */
export const pasteAddress = (address: string) =>
  `The sign-in ends on an error page. Copy its address, which starts with \`${address}\`, and paste it in Golem.`;
/** The step of a guide that ends a sign-in at `SIGN_IN_ADDRESS`. */
export const PASTE_ADDRESS = pasteAddress(SIGN_IN_ADDRESS);
