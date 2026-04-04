# /intake - Submit a New Requirement

## Description
Capture raw requirement input from any user and initiate the AI translation pipeline.

## Usage
```
/intake
```

## Behavior
1. Ask the user three questions in plain, friendly language:
   - **Who are you?** (role, department, or just a name)
   - **What do you want?** (in their own words, any format)
   - **Why?** (what problem does this solve, or what value does it bring)
2. Save the response to `intake/raw/YYYY-MM-DD-{slug}.md` where `{slug}` is a short kebab-case summary of the request.
3. Use the quick-idea template from `intake/templates/quick-idea.md` as the base format.
4. Automatically trigger the `/translate` workflow on the newly created file.
5. Confirm to the user: requirement received and processing has started.

## Constraints
- Accept ANY format of input. Never reject input for being too vague or unstructured.
- Preserve the user's exact words in the raw file.
- Add metadata (date, source) but do not edit the user's content.

## Output
- File created: `intake/raw/YYYY-MM-DD-{slug}.md`
- Status message to user confirming receipt
- Automatic handoff to `/translate`
