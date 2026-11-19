#!/usr/bin/env node
// 讀身分提供者公布的 JWKS，輸出匯入 sgn.idp_key 的 SQL（由 build.sh 以 owner 身分執行）。
// 這一步等於「登記信任的身分提供者金鑰」，是受控的 migration 動作，不是執行期的路徑。
import { loadConfig } from './lib/env.mjs';

const { idp } = loadConfig();
const discovery = await (await fetch(`${idp.SIM_IDP_ISSUER}/.well-known/openid-configuration`)).json();
const { keys } = await (await fetch(discovery.jwks_uri)).json();
const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;
for (const key of keys.filter((k) => k.kty === 'RSA' && (k.alg ?? 'RS256') === 'RS256')) {
    console.log(
        `insert into sgn.idp_key (kid, issuer, n, e) values (${quote(key.kid)}, ${quote(discovery.issuer)}, ` +
            `sgn_crypto.b64url_decode(${quote(key.n)}), sgn_crypto.b64url_decode(${quote(key.e)})) on conflict (kid) do nothing;`,
    );
}
