# Answer Code Question Feature

## Overview

This feature enhances the AI assistant's ability to answer questions about code by allowing it to retrieve contextual information from the indexed repository when the visible content on screen is insufficient.

## How It Works

### 1. AI Detection

When the user asks a non-trivial question about code (e.g., about imported functions, external dependencies, or complex logic), the AI will:

- Say **"Let me think..."** and ONLY that phrase
- **Wait silently** for the tool response without speculating or guessing
- Call the `answerCodeQuestion` tool
- Retrieve relevant information from the indexed codebase using semantic search
- Provide a comprehensive answer focused on **how the code works** and **key implementation details**
- **Avoid** mentioning file names, line numbers, or import statements unless specifically asked

### 2. Backend Integration

The feature integrates with the `/tools/review` endpoint on the backend server which:

- Uses QDrant vector database to find related context
- Retrieves function definitions and relevant code snippets
- Provides AI-generated answers with confidence scores and sources

### 3. Implementation Details

#### Files Modified

**`utils/api.ts`**

- Added `AnswerCodeQuestionRequest` interface
- Added `AnswerCodeQuestionResponse` interface
- Added `answerCodeQuestion()` function to call the `/tools/review` endpoint

**`App.tsx`**

- Imported the new API function and types
- Added `answerCodeQuestionFunctionDeclaration` with:
  - `question` (required): The user's question
  - `code` (optional): Code snippet being asked about
  - `file` (optional): File path of the code
  - `line` (optional): Line number or range
- Updated `SYSTEM_INSTRUCTION` to guide AI on when to use the tool
- Added handler for `answerCodeQuestion` tool calls that:
  - Validates required parameters
  - Calls the API with repo_id, question, and optional context
  - Passes walkthrough steps for additional context
  - Returns the answer to the AI session
- Registered the tool in the `functionDeclarations` array

#### Request Flow

```
User asks question
    ↓
AI says "Let me think..."
    ↓
AI calls answerCodeQuestion tool
    ↓
Tool handler sends POST to /tools/review
    ↓
Backend queries QDrant for context
    ↓
Backend generates contextual answer
    ↓
Response returned to AI
    ↓
AI speaks the answer
```

## Example Usage

**User:** "What does the `answerCodeQuestion` function do?"

**AI:** "Let me think..."

_[Waits silently while tool calls API with question and context]_

**AI:** "It's a service method that handles questions about code in a GitHub PR review context. It accepts parameters including the question itself and optional context like code snippets or file information. The function uses a vector database to search for related context - things like function definitions and relevant code snippets. It then generates a comprehensive answer using AI and returns it along with a confidence score and sources. Essentially, it helps answer questions about code by finding and analyzing relevant parts of the codebase."

## API Request Format

```typescript
{
  repo_id: "owner_repo",
  question: "What does this function do?",
  file: "src/utils/api.ts",        // optional
  line: "42-45",                    // optional
  code: "function example() {...}", // optional
  walkthrough: [...]                // optional array of walkthrough steps
}
```

## API Response Format

```typescript
{
  status: "success",
  answer: "The function does...",
  relatedContext: [...],
  confidence: 0.95,
  sources: ["file1.ts", "file2.ts"]
}
```

## Key Features

1. **Automatic Context Retrieval**: AI automatically determines when it needs more context
2. **Silent Waiting**: AI says "Let me think..." then waits silently without speculation until response arrives
3. **Implementation-Focused Answers**: Responses focus on how code works and key implementation details, avoiding unnecessary metadata like file paths and import statements
4. **Comprehensive Analysis**: Backend combines semantic search with AI reasoning
5. **Error Handling**: Graceful fallback if repository isn't indexed or API fails
6. **Optional Parameters**: Works with minimal information (just the question) or full context

## Requirements

- Repository must be indexed in the backend system
- `currentRepoId` must be available (set when repository is checked/initialized)
- Backend `/tools/review` endpoint must be available
