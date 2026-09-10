/**
 * electron-builder configuration.
 *
 * The base settings live in package.json ("build"); this file only layers code
 * signing on top of them. Everything is driven by environment variables, so no
 * certificate or secret ever lands in the repository, and a plain
 * `npm run pack:all` keeps producing unsigned artifacts when none is present.
 *
 * Two backends are supported (see docs/CODE_SIGNING.md):
 *
 *   1. Certificate file -- OV/EV certificate or a self-signed one for testing.
 *      electron-builder handles this natively, so nothing has to be configured
 *      here; we only report what is about to happen.
 *        CSC_LINK            path to the .pfx, or its base64
 *        CSC_KEY_PASSWORD    its password
 *
 *   2. Azure Trusted Signing -- no local certificate, billed monthly.
 *        AZURE_TRUSTED_SIGNING_ENDPOINT   https://<region>.codesigning.azure.net
 *        AZURE_TRUSTED_SIGNING_ACCOUNT    Code Signing Account name
 *        AZURE_TRUSTED_SIGNING_PROFILE    Certificate Profile name
 *      plus Entra ID credentials (AZURE_TENANT_ID / AZURE_CLIENT_ID /
 *      AZURE_CLIENT_SECRET) read by the Trusted Signing client itself.
 */

const base = require('./package.json').build;

/** Azure Trusted Signing config, or null when it is not fully configured. */
function azureOptions() {
  const endpoint = process.env.AZURE_TRUSTED_SIGNING_ENDPOINT;
  const codeSigningAccountName = process.env.AZURE_TRUSTED_SIGNING_ACCOUNT;
  const certificateProfileName = process.env.AZURE_TRUSTED_SIGNING_PROFILE;
  if (!endpoint || !codeSigningAccountName || !certificateProfileName) return null;
  return { endpoint, codeSigningAccountName, certificateProfileName };
}

module.exports = async () => {
  const win = { ...base.win };

  const azure = azureOptions();
  if (azure) {
    console.log(`[sign] Azure Trusted Signing: ${azure.codeSigningAccountName} / ${azure.certificateProfileName}`);
    win.azureSignOptions = azure;
  } else if (process.env.CSC_LINK || process.env.WIN_CSC_LINK) {
    // electron-builder picks these up by itself; no config field required.
    console.log('[sign] CSC_LINK present: signing with the supplied certificate file');
  } else {
    console.log('[sign] no signing material found -> artifacts will be UNSIGNED');
    console.log('[sign] see docs/CODE_SIGNING.md to enable signing');
  }

  return { ...base, win };
};
