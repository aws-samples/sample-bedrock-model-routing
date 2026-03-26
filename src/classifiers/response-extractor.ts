/**
 * Utility to extract the assistant's text response from a ConverseCommandOutput.
 * Used by the refusal classifier to get the text content for classification.
 */

import { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';

/**
 * Extract the assistant's text content from a ConverseCommandOutput.
 * Returns the concatenated text blocks from the output message.
 *
 * @param output The raw ConverseCommandOutput from Amazon Bedrock
 * @returns Concatenated text content, or empty string if no text blocks found
 */
export function extractResponseText(output: ConverseCommandOutput): string {
  const message = output.output?.message;
  if (!message?.content) {
    return '';
  }

  return message.content
    .filter(block => block.text !== undefined)
    .map(block => block.text!)
    .join(' ');
}
