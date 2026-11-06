#!/usr/bin/env node
// 打包/元数据回归测试：bundle 声明、展示元数据、图标与 patch 保持可安装状态。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const readJson = (relative) => JSON.parse(readFileSync(path.join(root, relative), 'utf8'))

test('package.json 是合法的 dsh bundle + web 客户端包', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.name, 'dsh-provider-badge')
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'index.js')
  assert.equal(pkg.license, 'MIT')

  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0)
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'))
})

test('exports 暴露运行时、bundle patch、locale 与图标', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.exports['.'], './index.js')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['./cordis.patch.yml'], './cordis.patch.yml')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  assert.equal(pkg.exports['./icon'], './icon.svg')

  for (const entry of ['index.js', 'client.js', 'cordis.patch.yml', 'install.ps1', 'README.md', 'LICENSE', 'locale/*.json', 'icon.svg']) {
    assert.ok(pkg.files.includes(entry), `files 应包含 ${entry}`)
  }
  assert.ok(pkg.files.includes('preview/capsule-dark.png'), 'README 引用的预览图应随包发布')
})

test('bundle patch 插入唯一的插件行', () => {
  const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /- id: dsh-provider-badge/)
  assert.match(patch, /name: 'dsh-provider-badge'/)
  const idLines = patch.split(/\r?\n/).filter((line) => /^\s*-\s+id:/.test(line))
  assert.equal(idLines.length, 1)
})

test('展示元数据：中英 locale 都有 meta.title / meta.description', () => {
  for (const locale of ['zh', 'en']) {
    const document = readJson(`locale/${locale}.json`)
    assert.equal(typeof document.meta, 'object')
    assert.ok(document.meta.title.trim().length > 0, `${locale} meta.title 不能为空`)
    assert.ok(document.meta.description.trim().length > 0, `${locale} meta.description 不能为空`)
  }
})

test('图标是合法、体量合规的 SVG', () => {
  const iconPath = path.join(root, 'icon.svg')
  assert.ok(existsSync(iconPath))
  const icon = readFileSync(iconPath)
  assert.ok(icon.length > 0 && icon.length <= 256 * 1024, '图标不应超过 256 KiB')
  const text = icon.toString('utf8')
  assert.match(text, /^<svg[\s>]/)
  assert.match(text, /viewBox="[^"]+"/)
  assert.match(text, /<\/svg>\s*$/)
})

test('README 不再包含已移除的调试通道，且记录安装/卸载/高度覆盖', () => {
  const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
  assert.doesNotMatch(readme, /59999/)
  assert.match(readme, /install_bundle/)
  assert.match(readme, /--dsh-provider-badge-height/)
  assert.match(readme, /-Uninstall/)
})

test('install.ps1 保留安装安全细节，且不含静默复制回退', () => {
  const script = readFileSync(path.join(root, 'install.ps1'), 'utf8')
  assert.match(script, /ItemType Junction/)
  assert.match(script, /-Uninstall/)
  assert.match(script, /New-Backup/)
  assert.match(script, /Get-PatchRegistrationState/)
  assert.match(script, /Find-InsertBlockStart/)
  assert.match(script, /Get-ProfileBundleState/)
  assert.doesNotMatch(script, /copied \(junction unavailable\)/)
  assert.doesNotMatch(script, /Copy-Item -LiteralPath \$PluginSource -Destination \$linkPath/)
  assert.doesNotMatch(script, /mklink/)
})

test('调试产物不随仓库发布', () => {
  assert.equal(existsSync(path.join(root, 'preview', 'trace.log')), false)
})
