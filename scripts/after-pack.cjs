const path = require('node:path')

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const productName = context.packager.appInfo.productName || 'Penpal'
  const executableName = context.packager.platformSpecificBuildOptions.executableName || productName
  const executablePath = path.join(context.appOutDir, `${executableName}.exe`)
  const version = context.packager.appInfo.version
  const { rcedit } = await import('rcedit')

  await rcedit(executablePath, {
    // electron-builder uses this for some installer assets, but the Windows
    // executable itself must also receive the icon resource explicitly.
    icon: path.join(context.packager.buildResourcesDir, 'icon.ico'),
    'file-version': version,
    'product-version': version,
    'version-string': {
      CompanyName: 'Penpal',
      FileDescription: productName,
      InternalName: executableName,
      OriginalFilename: `${executableName}.exe`,
      ProductName: productName
    }
  })
}
