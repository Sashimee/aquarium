/** What a sim query rejects with while the sim cannot answer; anything else is a bug. */
export class SimUnavailableError extends Error {
  constructor(message = 'The fish sim is not ready') {
    super(message);
    this.name = 'SimUnavailableError';
  }
}
