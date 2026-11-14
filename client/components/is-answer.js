// An answer is an assistant turn that said something; a failure or a cancel with no text is not one.
// The server has the same rule in server/lib/console.mjs; tests/console.test.mjs holds them together.
export const isAnswer = (t) => t.role !== 'user' && !((t.isError || t.cancelled) && !t.text);
