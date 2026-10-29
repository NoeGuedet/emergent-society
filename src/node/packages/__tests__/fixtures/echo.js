// The minimal authoring shape (kernel.md, the sandbox and local-log sections):
// plain JavaScript, no imports, evaluated as an async function body. The source
// returns one registration object; the handler stays in the child's memory, the
// wire carries only {name, description, parameters}.
return {
  tools: [
    {
      name: 'echo_text',
      description: 'echo the given text',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      handler: async (args) => ({ echoed: args.text }),
    },
  ],
};
