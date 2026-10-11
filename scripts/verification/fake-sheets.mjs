// Stand-in for server/sync/google-sheets.ts, so the REAL roster reader runs
// without Google. It opens no socket and reads no credential.
//
// Every call is RECORDED. That is what lets a test assert the reader is
// strictly read-only: a `batchUpdate` or an `addSheet` would show up here
// rather than being invisible because nothing was listening.

export const state = {
  /** The Badge Register's raw cell values, header row included. */
  values: [],
  /** Set to make the next `values.get` throw, like an API or network failure. */
  failNextRead: false,
  /** Ranges read, in order. */
  reads: [],
  /** Anything that would have MUTATED the spreadsheet. Must stay empty. */
  mutations: [],
}

export const reset = () => {
  state.values = []
  state.failNextRead = false
  state.reads = []
  state.mutations = []
}

const record = (operation) => {
  state.mutations.push(operation)

  return { data: {} }
}

export const createSheetsAccess = () => ({
  auth: { __fake: 'jwt' },
  client: {
    spreadsheets: {
      get: async () => {
        await Promise.resolve()

        return { data: { sheets: [{ properties: { title: 'Badge Register', sheetId: 1 } }] } }
      },
      batchUpdate: async () => {
        await Promise.resolve()

        return record('batchUpdate')
      },
      values: {
        get: async (args) => {
          await Promise.resolve()
          state.reads.push(args.range)

          if (state.failNextRead) {
            throw new Error('fake Sheets failure')
          }

          return { data: { values: state.values } }
        },
        batchGet: async () => {
          await Promise.resolve()

          return { data: { valueRanges: [{ values: state.values }] } }
        },
        update: async () => {
          await Promise.resolve()

          return record('values.update')
        },
      },
    },
  },
})
