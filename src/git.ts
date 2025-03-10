import exec from './exec'
import * as core from '@actions/core'
import {File, ChangeStatus} from './file'

export const NULL_SHA = '0000000000000000000000000000000000000000'
export const HEAD = 'HEAD'

export async function getChangesInLastCommit(): Promise<File[]> {
  core.startGroup(`Change detection in last commit`)
  let output = ''
  try {
    output = (await exec('git', ['log', '--format=', '--no-renames', '--name-status', '-z', '-n', '1'])).stdout
  } finally {
    fixStdOutNullTermination()
    core.endGroup()
  }

  return parseGitDiffOutput(output)
}

export async function getChanges(baseRef: string): Promise<File[]> {
  if (!(await hasCommit(baseRef))) {
    // Fetch single commit
    core.startGroup(`Fetching ${baseRef} from origin`)
    await exec('git', ['fetch', '--depth=1', '--no-tags', 'origin', baseRef])
    core.endGroup()
  }

  // Get differences between ref and HEAD
  core.startGroup(`Change detection ${baseRef}..HEAD`)
  let output = ''
  try {
    // Two dots '..' change detection - directly compares two versions
    output = (await exec('git', ['diff', '--no-renames', '--name-status', '-z', `${baseRef}..HEAD`])).stdout
  } finally {
    fixStdOutNullTermination()
    core.endGroup()
  }

  return parseGitDiffOutput(output)
}

export async function getChangesOnHead(): Promise<File[]> {
  // Get current changes - both staged and unstaged
  core.startGroup(`Change detection on HEAD`)
  let output = ''
  try {
    output = (await exec('git', ['diff', '--no-renames', '--name-status', '-z', 'HEAD'])).stdout
  } finally {
    fixStdOutNullTermination()
    core.endGroup()
  }

  return parseGitDiffOutput(output)
}

export async function getChangesSinceMergeBase(base: string, ref: string, initialFetchDepth: number): Promise<File[]> {
  let baseRef: string | undefined
  async function hasMergeBase(): Promise<boolean> {
    return (
      baseRef !== undefined && (await exec('git', ['merge-base', baseRef, ref], {ignoreReturnCode: true})).code === 0
    )
  }

  let noMergeBase = false
  core.startGroup(`Searching for merge-base ${base}...${ref}`)
  try {
    baseRef = await getFullRef(base)
    if (!(await hasMergeBase())) {
      await exec('git', ['fetch', '--no-tags', `--depth=${initialFetchDepth}`, 'origin', base, ref])
      if (baseRef === undefined) {
        baseRef = await getFullRef(base)
        if (baseRef === undefined) {
          await exec('git', ['fetch', '--tags', `--depth=1`, 'origin', base, ref])
          baseRef = await getFullRef(base)
          if (baseRef === undefined) {
            throw new Error(`Could not determine what is ${base} - fetch works but it's not a branch or tag`)
          }
        }
      }

      let depth = initialFetchDepth
      let lastCommitCount = await getCommitCount()
      while (!(await hasMergeBase())) {
        depth = Math.min(depth * 2, Number.MAX_SAFE_INTEGER)
        await exec('git', ['fetch', `--deepen=${depth}`, 'origin', base, ref])
        const commitCount = await getCommitCount()
        if (commitCount === lastCommitCount) {
          core.info('No more commits were fetched')
          core.info('Last attempt will be to fetch full history')
          await exec('git', ['fetch'])
          if (!(await hasMergeBase())) {
            noMergeBase = true
          }
          break
        }
        lastCommitCount = commitCount
      }
    }
  } finally {
    core.endGroup()
  }

  let diffArg = `${baseRef}...${ref}`
  if (noMergeBase) {
    core.warning('No merge base found - change detection will use direct <commit>..<commit> comparison')
    diffArg = `${baseRef}..${ref}`
  }

  // Get changes introduced on ref compared to base
  core.startGroup(`Change detection ${diffArg}`)
  let output = ''
  try {
    // Three dots '...' change detection - finds merge-base and compares against it
    output = (await exec('git', ['diff', '--no-renames', '--name-status', '-z', diffArg])).stdout
  } finally {
    fixStdOutNullTermination()
    core.endGroup()
  }

  return parseGitDiffOutput(output)
}

export function parseGitDiffOutput(output: string): File[] {
  const tokens = output.split('\u0000').filter(s => s.length > 0)
  const files: File[] = []
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    files.push({
      status: statusMap[tokens[i]],
      filename: tokens[i + 1]
    })
  }
  return files
}

export async function listAllFilesAsAdded(): Promise<File[]> {
  core.startGroup('Listing all files tracked by git')
  let output = ''
  try {
    output = (await exec('git', ['ls-files', '-z'])).stdout
  } finally {
    fixStdOutNullTermination()
    core.endGroup()
  }

  return output
    .split('\u0000')
    .filter(s => s.length > 0)
    .map(path => ({
      status: ChangeStatus.Added,
      filename: path
    }))
}

export async function getCurrentRef(): Promise<string> {
  core.startGroup(`Determining current ref`)
  try {
    const branch = (await exec('git', ['branch', '--show-current'])).stdout.trim()
    if (branch) {
      return branch
    }

    const describe = await exec('git', ['describe', '--tags', '--exact-match'], {ignoreReturnCode: true})
    if (describe.code === 0) {
      return describe.stdout.trim()
    }

    return (await exec('git', ['rev-parse', HEAD])).stdout.trim()
  } finally {
    core.endGroup()
  }
}

export function getShortName(ref: string): string {
  if (!ref) return ''

  const heads = 'refs/heads/'
  const tags = 'refs/tags/'

  if (ref.startsWith(heads)) return ref.slice(heads.length)
  if (ref.startsWith(tags)) return ref.slice(tags.length)

  return ref
}

export function isGitSha(ref: string): boolean {
  return /^[a-z0-9]{40}$/.test(ref)
}

async function hasCommit(ref: string): Promise<boolean> {
  core.startGroup(`Checking if commit for ${ref} is locally available`)
  try {
    return (await exec('git', ['cat-file', '-e', `${ref}^{commit}`], {ignoreReturnCode: true})).code === 0
  } finally {
    core.endGroup()
  }
}

async function getCommitCount(): Promise<number> {
  const output = (await exec('git', ['rev-list', '--count', '--all'])).stdout
  const count = parseInt(output)
  return isNaN(count) ? 0 : count
}

async function getFullRef(shortName: string): Promise<string | undefined> {
  if (isGitSha(shortName)) {
    return shortName
  }

  const output = (await exec('git', ['show-ref', shortName], {ignoreReturnCode: true})).stdout
  const refs = output
    .split(/\r?\n/g)
    .map(l => l.match(/refs\/.*$/)?.[0] ?? '')
    .filter(l => l !== '')

  if (refs.length === 0) {
    return undefined
  }

  const remoteRef = refs.find(ref => ref.startsWith('refs/remotes/origin/'))
  if (remoteRef) {
    return remoteRef
  }

  return refs[0]
}

function fixStdOutNullTermination(): void {
  // Previous command uses NULL as delimiters and output is printed to stdout.
  // We have to make sure next thing written to stdout will start on new line.
  // Otherwise things like ::set-output wouldn't work.
  core.info('')
}

const statusMap: {[char: string]: ChangeStatus} = {
  A: ChangeStatus.Added,
  C: ChangeStatus.Copied,
  D: ChangeStatus.Deleted,
  M: ChangeStatus.Modified,
  R: ChangeStatus.Renamed,
  U: ChangeStatus.Unmerged
}
