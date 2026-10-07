import { Schema } from 'effect'

/** One Field as the Note Type's JSON column stores it. */
export const StoredField = Schema.Struct({ ord: Schema.Number, name: Schema.String })

/** One Template as the Note Type's JSON column stores it. */
export const StoredTemplate = Schema.Struct({
  ord: Schema.Number,
  name: Schema.String,
  questionFormat: Schema.String,
  answerFormat: Schema.String,
})
