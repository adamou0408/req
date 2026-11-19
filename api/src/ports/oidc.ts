/** OIDC port：SSO 登入（authorization code flow + PKCE）。 */
import type { LoginIdentity } from '../contract/systemCalls.ts';

export interface OidcLoginStart {
  /** 要把瀏覽器導過去的網址。 */
  url: string;
  /** 以下三個存在簽章 cookie 裡，callback 時交回來驗證。 */
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcPort {
  startLogin(): Promise<OidcLoginStart>;
  /** callbackUrl 是身分提供者導回來的完整網址（含 code、state）。驗證失敗就丟例外。 */
  finishLogin(
    callbackUrl: URL,
    expected: { state: string; nonce: string; codeVerifier: string },
  ): Promise<LoginIdentity>;
}
