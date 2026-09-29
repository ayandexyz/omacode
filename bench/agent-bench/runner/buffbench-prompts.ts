// =============================================================================
// BuffBench's commit-screen and task-generator prompts.
// Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md §4.2 step 4, §4.3.
//
// Derived from Codebuff's BuffBench (evals/buffbench/pick-commits.ts and
// eval-task-generator.ts), Copyright 2025 Codebuff, Apache License 2.0.
// Extracted from their source by script, not retyped. Two edits, both forced
// by running under `codex exec` instead of Codebuff's agent runtime:
//   - GENERATOR_SYSTEM drops the two Codebuff template placeholders (file tree,
//     knowledge files). Codex lists the tree itself and reads the checkout's
//     AGENTS.md / CLAUDE.md, which is what those placeholders supplied.
//   - GENERATOR_INSTRUCTIONS step 2 said to spawn Codebuff's file-picker and
//     code-searcher subagents, which do not exist here. It now says to explore
//     with read-only shell commands, the same job with Codex's own tool.
// =============================================================================

export const COMMIT_SCREENING_PROMPT = `You are an expert at identifying HARD and CHALLENGING code changes in git commits that would make difficult evaluation examples for an AI coding assistant.

**IMPORTANT: We only want HARD commits. We have enough easy tasks already. Be very selective and only pick commits that represent genuinely difficult coding challenges.**

Given a commit with its actual file changes and diffs, determine if it represents a HARD, substantial, and complex change that would challenge an advanced AI coding assistant.

A good HARD evaluation commit MUST:
1. Require deep understanding of the codebase architecture or complex domain logic
2. Involve non-trivial algorithmic thinking, state management, or system design
3. Touch multiple interconnected parts of the system that require understanding dependencies
4. Implement complex business logic, data transformations, or intricate control flow
5. Require reasoning about edge cases, error handling, or concurrent operations
6. Demonstrate advanced programming patterns (e.g., complex generics, metaprogramming, advanced async patterns)
7. Involve substantial refactoring that requires understanding the full context
8. Have changes that would be difficult to implement correctly without deep understanding

**REJECT commits that are:**
- Simple bug fixes or one-liner changes (TOO EASY)
- Straightforward CRUD operations or basic UI changes (TOO EASY)
- Adding simple new fields or properties (TOO EASY)
- Basic configuration changes (TOO EASY)
- Simple utility functions with obvious implementations (TOO EASY)
- Dependency updates (package.json, lock files)
- Auto-generated code (generated files, build outputs)
- Pure formatting or linting changes
- Documentation-only changes
- Merge commits or reverts
- Mass renaming or file moves without logic changes
- Changes that only modify comments or whitespace
- Simple test additions without complex logic
- Boilerplate code additions

**Examples of HARD commits we want:**
- Implementing a complex caching strategy with invalidation logic
- Adding a new authentication/authorization system
- Refactoring a component to support a fundamentally different data model
- Implementing complex state machines or workflow engines
- Adding real-time synchronization or conflict resolution
- Complex database migrations with data transformations
- Implementing advanced search/filtering with multiple criteria
- Adding complex validation logic across multiple entities
- Performance optimizations requiring algorithmic changes
- Implementing complex integrations with external systems

When evaluating, ask yourself:
- Would this take a senior developer significant time to implement correctly?
- Does this require understanding multiple files/modules and their interactions?
- Are there non-obvious edge cases or gotchas that must be handled?
- Would an AI need to reason deeply about the problem, not just pattern match?

Be VERY selective. If in doubt, REJECT the commit. We want quality over quantity.

For each commit you select:
- Explain specifically WHY this is a HARD task (not just "substantial" or "meaningful")
- Identify the specific complexity or challenge involved
- Write a short description (1-2 sentences) of what the commit accomplishes

Return your response as JSON with the selected commits. If none of the commits are hard enough, return an empty array.`;

export const GENERATOR_SYSTEM = `You are an expert at analyzing git commits and generating evaluation tasks for AI coding assistants.

You will receive:
- A git diff showing the changes made
- The list of files that were edited
- An optional commit message
- The repository directory where you can explore the codebase

You must generate both a specification (spec) and a user prompt for the task.
`;

export const GENERATOR_INSTRUCTIONS = `Your task:
1. Analyze the git diff to understand what changed
2. Explore the codebase with read-only shell commands (ls, rg, cat) to understand context.
3. Read as many files relevant to the changes as possible.
4. Generate the output, including:
- a short, descriptive task ID (2-3 hyphenated words like "fix-auth-bug" or "refactor-login-flow")
- a clear specification describing exactly what needs to be implemented
- a high-level user prompt that describes what needs to be done leaving out details that should be reconstructed by the agent
- supplemental files that would help a judge understand the change (exclude directly edited files)

Key principles for the task ID:
- 2-3 words maximum, hyphenated (e.g., "fix-memory-leak", "add-user-profile", "refactor-auth-flow")
- Descriptive but concise
- Use action verbs when appropriate (fix, add, remove, refactor, update, implement)
- Lowercase with hyphens

Key principles for the spec:
- Prescribe exactly how to make the change with references to the files that need to be changed
- Not include code
- Focus on the observable behavior or structure that needs to be implemented
- Be clear enough that a skilled developer or AI could implement it from scratch
- Be phrased as what needs to be done, not what was already done
- Cover all the changes shown across multiple files

Key principles for the prompt:
- Focus on the high-level functional requirements, not implementation details
- Use natural language: "add user authentication" not "implement authenticateUser function"
- Omit details that should be reconstructed by the agent
- Be clear enough that a skilled developer could implement from scratch
- Consider the commit message as a hint but don't just copy it
`;
