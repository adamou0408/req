/** 依設定挑選各個 port 的實作。要換成真實系統時，加一個 adapter 並在這裡接上。 */
import type { Config } from '../config.ts';
import type { SystemCalls } from '../contract/systemCalls.ts';
import { ManualDc } from './adapters/dcManual.ts';
import { MockDc } from './adapters/dcMock.ts';
import { JsonFileCatalog, JsonFileDirectory } from './adapters/jsonFile.ts';
import { ConsoleMail, type ConsoleMailSink } from './adapters/mailConsole.ts';
import { SmtpMail } from './adapters/mailSmtp.ts';
import { DevMfa } from './adapters/mfaDev.ts';
import { TotpMfa } from './adapters/mfaTotp.ts';
import { OpenidClientOidc } from './adapters/oidcOpenidClient.ts';
import type { CatalogPort } from './catalog.ts';
import type { DcPort } from './dc.ts';
import type { DirectoryPort } from './directory.ts';
import type { MailPort } from './mail.ts';
import type { MfaPort } from './mfa.ts';
import type { OidcPort } from './oidc.ts';

export interface Ports {
  mail: MailPort;
  dc: DcPort;
  mfa: MfaPort;
  /** null＝OIDC 登入未啟用（AUTH_MODE=dev，或 OIDC 設定不全）。 */
  oidc: OidcPort | null;
  /** null＝沒有設定 DIRECTORY_FILE／CATALOG_FILE。 */
  directory: DirectoryPort | null;
  catalog: CatalogPort | null;
}

export interface PortDeps {
  config: Config;
  sys: Pick<SystemCalls, 'totpSecret'>;
  log: ConsoleMailSink;
  now: () => number;
}

export function createPorts({ config, sys, log, now }: PortDeps): Ports {
  return {
    mail: config.mailMode === 'smtp' && config.smtp ? new SmtpMail(config.smtp) : new ConsoleMail(log),
    dc: config.dcMode === 'mock' ? new MockDc() : new ManualDc(),
    mfa:
      config.mfaMode === 'dev'
        ? new DevMfa(config.mfaDevCode)
        : new TotpMfa({ getSecret: (actor) => sys.totpSecret(actor), now }),
    oidc: config.authMode === 'oidc' && config.oidc ? new OpenidClientOidc(config.oidc) : null,
    directory: config.directoryFile ? new JsonFileDirectory(config.directoryFile) : null,
    catalog: config.catalogFile ? new JsonFileCatalog(config.catalogFile) : null,
  };
}
