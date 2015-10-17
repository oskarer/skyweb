declare module 'request' {
  export = RequestAPI;
  module RequestAPI {
    export interface CookieJar {
			setCookie(): string
		}
  }
}
