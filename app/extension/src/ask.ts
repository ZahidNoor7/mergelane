/** Every message an extension page sends the background carries this `what`. uBO Lite's
 * background (ADR-0063) shares the extension's messages: its listener reads `what`, and leaves any
 * whose `what` holds a colon to other listeners. No extension APIs here, so e2e specs can import it. */
export const ASK = 'mergelane:ask'
