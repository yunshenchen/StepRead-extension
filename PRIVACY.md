# StepRead Privacy Policy

Last updated: July 13, 2026

StepRead is a Microsoft Edge extension for reading PDFs, creating highlights, asking questions about selected text, and organizing reading notes into a knowledge view.

## Data Stored Locally

StepRead stores extension data in the user's browser storage, including:

- Extension settings, such as AI endpoint, model name, demo mode, reading layout, theme, and context options.
- Imported or opened PDF reading records.
- Extracted PDF text blocks and document metadata used by the reader.
- User-created highlights.
- User questions, assistant answers, thread history, summaries, and knowledge report cache.
- AI request logs used inside the extension to show request status and debugging information.

This data is stored locally in the browser extension's storage and IndexedDB.

## AI Requests

StepRead can call an OpenAI-compatible AI service configured by the user. AI features are optional. By default, StepRead starts in demo mode and does not need a real API key.

When the user configures an AI API key, disables demo mode, and actively asks a question or generates a knowledge report, StepRead sends the selected text and the enabled reading context to the configured AI service. Depending on the user's context settings, this may include selected text, nearby text blocks, document outline, current chapter text, highlight history, question-answer history, summaries, or other document context needed to answer the user's request.

StepRead does not send document text to an AI service unless the user uses an AI feature that requires a model response.

## API Keys

The user's AI API key is saved in the browser extension's local storage. StepRead uses the key only to send requests to the AI endpoint configured by the user. StepRead does not publish, sell, or intentionally share the user's API key.

## Website and PDF Access

StepRead uses browser permissions to open the current PDF in the StepRead reader and to load PDF source URLs selected by the user. The extension is designed for user-initiated PDF reading workflows.

StepRead does not track general browsing history for advertising or profiling.

## Data Sharing

StepRead does not sell user data.

StepRead does not share user data with advertisers or data brokers.

When the user uses AI features, selected reading content and configured context are sent to the AI service chosen by the user. That AI service may process the submitted content according to its own terms and privacy policy.

## Remote Code

StepRead is a Manifest V3 extension and does not load or execute remotely hosted code. Extension code is included in the extension package.

## Data Deletion

Users can remove StepRead data by:

- Deleting reading records inside StepRead when available.
- Clearing extension storage in Microsoft Edge.
- Removing the StepRead extension from Microsoft Edge.

Removing the extension deletes extension-managed local data according to Microsoft Edge's extension storage behavior.

## Contact

For support or privacy questions, use the support contact listed on the StepRead Microsoft Edge Add-ons listing.
