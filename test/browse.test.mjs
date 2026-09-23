/**
 * 目录浏览：手机挑工作区时读的那一层。
 *
 * 这里**用真实的临时目录**，不用桩。原因是这个模块的几条要害边界全是
 * 「真的碰了磁盘才会露出来」的：
 *   - 只列目录、不列文件（桩里怎么造都行，真盘上才有文件混在里面）
 *   - 名字里的 `..` 或斜杠会不会让新建落到别处（要看真的有没有多出东西）
 *   - 大小写不敏感的排序（要有一批真名字才看得出来）
 *
 * 桩能证明「我按我想的调用了 fs」，真目录能证明「fs 真的干了那件事」。
 * 这里要的是后者。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'

import {
  MAX_DIRS, MAX_RECENT, ancestorsOf, listDirectory, listRoots,
  makeDirectory, normalizePath, validDirName,
} from '../lib/browse.js'

/** 每个用例一个干净的临时目录，跑完删掉。 */
async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-remote-browse-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------------------
// 目录名的合法口径
// ---------------------------------------------------------------------------

test('合法目录名照收', () => {
  for (const name of ['项目', 'my-project', 'a.b', 'a b', 'a_b-1', '..a', 'a..']) {
    assert.equal(validDirName(name), true, `${name} 应该是合法的`)
  }
})

test('目录名不合法的一律挡掉', () => {
  const bad = ['', '   ', '.', '..', 'a/b', 'a\\b', 'a\0b', null, undefined, 42, {}]
  for (const name of bad) {
    assert.equal(validDirName(name), false, `${JSON.stringify(name)} 应该被挡掉`)
  }
})

test('路径规范化会把 .. 和 . 算掉', () => {
  // 这是故意的：不猜用户想干什么，只保证拿去读的是一条干净的绝对路径。
  const out = normalizePath(join('I:', 'a', '..', 'b', '.', 'c'))
  assert.equal(out, join('I:', 'b', 'c'))
})

test('畸形路径直接拒绝，不试着修补', () => {
  for (const bad of ['', '   ', 'a\0b', null, undefined, 42, {}]) {
    assert.equal(normalizePath(bad), null, `${JSON.stringify(bad)} 应该被拒绝`)
  }
})

test('面包屑是从根到目标那一串', () => {
  const out = ancestorsOf(join('I:', 'a', 'b', 'c'))
  assert.equal(out[0].path, parse(join('I:', 'a')).root, '第一格是根')
  assert.deepEqual(out.map((x) => x.name).slice(1), ['a', 'b', 'c'])
  assert.equal(out.at(-1).path, join('I:', 'a', 'b', 'c'), '最后一格是目标自己')
})

test('面包屑是纯字符串算的，目录读不出来也画得出来', () => {
  // 读失败时界面还得有面包屑，不然用户卡在空白页上连退都退不回去。
  const ghost = join('I:', '这个目录不存在', '子目录')
  assert.equal(ancestorsOf(ghost).at(-1).path, ghost)
})

// ---------------------------------------------------------------------------
// 列目录
// ---------------------------------------------------------------------------

test('只列目录，文件一个都不出现', async (t) => {
  const dir = await sandbox(t)
  await mkdir(join(dir, '甲'))
  await mkdir(join(dir, '乙'))
  await writeFile(join(dir, 'README.md'), '内容')
  await writeFile(join(dir, '密钥.txt'), '不该被看到')

  const out = await listDirectory(dir)
  assert.equal(out.ok, true)
  assert.deepEqual(out.dirs.map((d) => d.name), ['甲', '乙'])
  // 连名字都不该出现在返回里——不是「界面上不显示」，是根本不该传出去。
  assert.equal(JSON.stringify(out).includes('README'), false, '文件名不该出现在返回里')
  assert.equal(JSON.stringify(out).includes('密钥'), false, '文件名不该出现在返回里')
})

test('返回的每一项都带完整路径，手机不用自己拼', async (t) => {
  const dir = await sandbox(t)
  await mkdir(join(dir, '甲'))
  const out = await listDirectory(dir)
  assert.equal(out.dirs[0].path, join(out.path, '甲'))
})

test('排序不区分大小写（Windows 上名字本来就不区分）', async (t) => {
  const dir = await sandbox(t)
  for (const name of ['zebra', 'Apple', 'banana', 'Cherry']) await mkdir(join(dir, name))
  const out = await listDirectory(dir)
  // 按码点排的话大写会全跑到前面：Apple Cherry banana zebra
  assert.deepEqual(out.dirs.map((d) => d.name), ['Apple', 'banana', 'Cherry', 'zebra'])
})

test('指向目录的符号链接算目录', async (t) => {
  const dir = await sandbox(t)
  await mkdir(join(dir, '真目录'))
  try {
    await symlink(join(dir, '真目录'), join(dir, '链接'), 'junction')
  } catch (err) {
    return // 没权限建链接（Windows 上可能要开发者模式）就跳过，不算失败
  }
  const out = await listDirectory(dir)
  assert.deepEqual(out.dirs.map((d) => d.name).sort(), ['链接', '真目录'].sort())
})

test('目录不存在时如实报读不到，不装作空目录', async (t) => {
  const dir = await sandbox(t)
  const out = await listDirectory(join(dir, '没有这个'))
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'unreadable', '空目录和读不到在界面上长得一样，必须分开')
})

test('路径畸形时报 bad-path，不去碰磁盘', async () => {
  for (const bad of ['', 'a\0b', null]) {
    const out = await listDirectory(bad)
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'bad-path')
  }
})

test('超大目录会截断，并且如实说总数', async (t) => {
  const dir = await sandbox(t)
  // 造 MAX_DIRS + 5 个，验证封顶和 total 都对。
  for (let i = 0; i < MAX_DIRS + 5; i += 1) {
    await mkdir(join(dir, 'd' + String(i).padStart(4, '0')))
  }
  const out = await listDirectory(dir)
  assert.equal(out.dirs.length, MAX_DIRS, '要封顶')
  assert.equal(out.truncated, true)
  assert.equal(out.total, MAX_DIRS + 5, '总数要如实报，界面才说得清「只列了前 N 个」')
})

// ---------------------------------------------------------------------------
// 新建文件夹
// ---------------------------------------------------------------------------

test('能新建文件夹，返回它的完整路径', async (t) => {
  const dir = await sandbox(t)
  const out = await makeDirectory(dir, '新项目')
  assert.equal(out.ok, true)
  assert.equal(out.path, join(dir, '新项目'))
  assert.ok(existsSync(out.path), '磁盘上真的要有一个')
})

test('同名文件夹已存在时如实说已存在', async (t) => {
  const dir = await sandbox(t)
  await mkdir(join(dir, '甲'))
  const out = await makeDirectory(dir, '甲')
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'exists')
})

test('名字里带 .. 或斜杠时，一个字节都不许落到别处', async (t) => {
  // 这是这个模块最要紧的一条：手机是网络对面来的输入。
  // 光断言「返回 bad-name」不够——必须确认**磁盘上真的没多出东西**。
  //
  // 越界目标用一次性名字（带上这次的时间戳），不用固定名：固定名会被上一轮
  // 留下的残留污染（我自己的反向验证就跑出过一次，测试当场逮住了），
  // 那种红是假红，会让人以为代码坏了。
  const dir = await sandbox(t)
  const escapee = '跑出去-' + Date.now()
  const parent = join(dir, '..')
  const before = (await readdir(dir)).length

  for (const name of ['../' + escapee, '..\\' + escapee, 'a/b', 'a\\b', '..', '.', '', '   ']) {
    const out = await makeDirectory(dir, name)
    assert.equal(out.ok, false, `${JSON.stringify(name)} 不该建成功`)
    assert.equal(out.reason, 'bad-name')
  }

  assert.equal((await readdir(dir)).length, before, '选中的目录里不该多出东西')
  // 父目录那边**只查这个名字**，不数条目数：父目录是系统的临时目录，
  // 随时有别的东西在增删，数条目数会随机红。
  assert.equal(existsSync(join(parent, escapee)), false, '越界目标不该存在')
})

test('父目录不存在时不硬建，如实报错', async (t) => {
  const dir = await sandbox(t)
  const out = await makeDirectory(join(dir, '没有这个'), '子')
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'failed')
})

// ---------------------------------------------------------------------------
// 常用位置
// ---------------------------------------------------------------------------

test('常用位置里有主目录和盘符', async () => {
  const out = await listRoots()
  assert.equal(out.home, homedir())
  assert.ok(out.drives.length > 0, '至少得有一个盘，不然手机没地方点')
  if (process.platform === 'win32') {
    assert.ok(out.drives.every((d) => /^[A-Z]:\\$/.test(d)), `盘符形状不对：${out.drives}`)
  }
})

test('最近用过的目录去重、去掉主目录、封顶', async () => {
  const home = homedir()
  const many = Array.from({ length: MAX_RECENT + 4 }, (_, i) => join('I:', '项目' + i))
  const out = await listRoots({ recent: [home, ...many, many[0], '', null, 42] })
  assert.equal(out.recent.length, MAX_RECENT, '要封顶')
  assert.equal(out.recent.includes(home), false, '主目录已经在上面单独给了，别重复')
  assert.equal(new Set(out.recent).size, out.recent.length, '不该有重复项')
  assert.equal(out.recent.every((p) => typeof p === 'string' && p), true, '不该混进垃圾值')
})
