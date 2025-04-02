export async function run(input, sdk) {
  try {
    const request = input.request;
    const response = input.response;

    if (!request || !response) {
      sdk.console.log("Missing request or response data - skipping analysis");
      return;
    }
    let rawRequest = request.getRaw().toText();
    let rawResponse = response.getRaw().toText();
    let openaiApiKey = ""; // Replace with your actual OpenAI API key

    sdk.console.log(
      `Request length: ${rawRequest.length}, Response length: ${rawResponse.length}`
    );

    // Create a truncation function that can be reused with different sizes
    const truncateContent = (req, res, maxTotalLength) => {
      // Determine how much to keep of each part (proportionally)
      const totalLength = req.length + res.length;
      const requestRatio = req.length / totalLength;
      const maxRequestLength = Math.floor(maxTotalLength * requestRatio);
      const maxResponseLength = maxTotalLength - maxRequestLength;

      // Truncate request and response
      let truncatedRequest = req;
      let truncatedResponse = res;

      if (req.length > maxRequestLength) {
        truncatedRequest =
          req.substring(0, maxRequestLength) +
          "\n[... Request truncated due to size limits ...]";
      }

      if (res.length > maxResponseLength) {
        truncatedResponse =
          res.substring(0, maxResponseLength) +
          "\n[... Response truncated due to size limits ...]";
      }

      return {
        request: truncatedRequest,
        response: truncatedResponse,
      };
    };

    const createPrompt = (req, res) => {
      return `
  You are an API analysis assistant. Your task is to analyze HTTP transactions and provide detailed, accurate pseudocode that reflects the server-side implementation. Focus on functionality. Be specific, technical, and thorough in your analysis. Your analysis should include:
1. A detailed explanation of what this API endpoint does
2. The likely data flow between client, server, and any databases
3. Detailed pseudocode that shows how the server likely processes this request
4. The programming language/framework most likely used

For the pseudocode:
- Include input validation steps
- Show database queries if applicable
- Include authentication/authorization checks
- Detail any business logic or algorithms
- Show how the response is constructed

  Analyze the following HTTP transaction and infer the backend server logic that generated this response.
Provide detailed pseudocode that reflects the server-side implementation.

===REQUEST===
${req}

===RESPONSE===
${res}
`;
    };

    try {
      // Validate API key is present
      if (!openaiApiKey || openaiApiKey === "YOUR_OPENAI_API_KEY_HERE") {
        sdk.console.log(
          "OpenAI API key is missing. Please add your API key to the script."
        );
        await sdk.findings.create({
          title: "Pseudocode Analysis Error",
          description:
            "Failed to generate pseudocode analysis: OpenAI API key is missing",
          severity: "low",
          reporter: "OpenAI-Pseudocode-Analysis",
          request: request,
        });
        return;
      }

      // Use small content size
      // Tokens are roughly 3-4 chars each, so 50K chars should be well under the limit
      const MAX_TOTAL_LENGTH = 50000;

      // Truncate the content
      const truncated = truncateContent(
        rawRequest,
        rawResponse,
        MAX_TOTAL_LENGTH
      );
      let usedRequest = truncated.request;
      let usedResponse = truncated.response;

      sdk.console.log(
        `Truncated request length: ${usedRequest.length}, Truncated response length: ${usedResponse.length}`
      );

      // Create the prompt with truncated content
      let prompt = createPrompt(usedRequest, usedResponse);
      sdk.console.log(`Prompt length: ${prompt.length}`);

      try {
        // Send request to OpenAI API with truncated content
        let spec;
        try {
          sdk.console.log("Creating RequestSpec...");
          spec = new RequestSpec("https://api.openai.com/v1/chat/completions");
          sdk.console.log("RequestSpec created successfully");
        } catch (error) {
          sdk.console.log(`Error creating RequestSpec: ${error.message}`);
          throw error;
        }

        try {
          sdk.console.log("Setting method...");
          spec.setMethod("POST");
          sdk.console.log("Setting headers...");
          spec.setHeader("Content-Type", "application/json");
          spec.setHeader("Authorization", `Bearer ${openaiApiKey}`);
          sdk.console.log("Setting query...");
          spec.setQuery("");
          sdk.console.log("Removing cookie header...");
          spec.removeHeader("Cookie");
        } catch (error) {
          sdk.console.log(`Error configuring request: ${error.message}`);
          throw error;
        }

        let openaiPayload;
        try {
          sdk.console.log("Creating payload...");
          openaiPayload = {
            model: "o3-mini",
            messages: [
              {
                role: "user",
                content: prompt,
              },
            ],
          };
        } catch (error) {
          sdk.console.log(`Error creating payload: ${error.message}`);
          throw error;
        }

        try {
          sdk.console.log("Setting request body...");
          spec.setBody(JSON.stringify(openaiPayload));
        } catch (error) {
          sdk.console.log(`Error setting request body: ${error.message}`);
          throw error;
        }

        let openaiResult;
        let body;
        let retryCount = 0;
        const MAX_RETRIES = 3;
        const RETRY_DELAY = 2000; // 2 seconds delay between retries

        // Helper function to delay execution
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        // Loop to handle retries
        while (retryCount < MAX_RETRIES) {
          try {
            sdk.console.log(
              `Attempt ${retryCount + 1}: Sending request to OpenAI API...`
            );

            if (typeof sdk.requests.send !== "function") {
              sdk.console.log(
                `sdk.requests.send is not a function: ${typeof sdk.requests
                  .send}`
              );
              throw new Error("sdk.requests.send is not a function");
            }

            openaiResult = await sdk.requests.send(spec);

            if (!openaiResult) {
              sdk.console.log("No result received from OpenAI API");
              throw new Error("No result received from OpenAI API");
            }

            // Safely check response properties
            sdk.console.log("Received response, inspecting...");
            sdk.console.log(
              `Response object keys: ${Object.keys(openaiResult).join(", ")}`
            );

            // Extract the response body
            let responseText = "";
            if (openaiResult.response) {
              sdk.console.log(
                `Response.response object keys: ${Object.keys(
                  openaiResult.response
                ).join(", ")}`
              );

              // Get response body
              let responseBody;
              if (typeof openaiResult.response.getBody === "function") {
                responseBody = openaiResult.response.getBody();
                if (typeof responseBody.toText === "function") {
                  responseText = responseBody.toText();
                } else if (typeof responseBody.toJson === "function") {
                  body = responseBody.toJson();
                  responseText = JSON.stringify(body);
                } else if (responseBody.toString) {
                  responseText = responseBody.toString();
                }
              } else if (openaiResult.response.body) {
                if (typeof openaiResult.response.body === "string") {
                  responseText = openaiResult.response.body;
                } else {
                  responseText = JSON.stringify(openaiResult.response.body);
                  body = openaiResult.response.body;
                }
              }
            } else if (openaiResult.body) {
              if (typeof openaiResult.body === "string") {
                responseText = openaiResult.body;
              } else {
                responseText = JSON.stringify(openaiResult.body);
                body = openaiResult.body;
              }
            }

            // Try to parse as JSON if we don't have a body object yet
            if (!body && responseText) {
              try {
                body = JSON.parse(responseText);
              } catch (parseError) {
                sdk.console.log(
                  `Failed to parse response as JSON: ${parseError.message}`
                );
              }
            }

            // Check for errors in the response
            if (body && body.error) {
              const errorMsg = body.error.message || JSON.stringify(body.error);
              sdk.console.log(`Error in response: ${errorMsg}`);

              // Check if it's a token limit or content length error
              if (
                errorMsg.includes("string too long") ||
                errorMsg.includes("maximum length") ||
                errorMsg.includes("maximum context length") ||
                errorMsg.includes("reduce the length")
              ) {
                // Further reduce content size
                const newMaxLength = Math.floor(MAX_TOTAL_LENGTH / 2);
                sdk.console.log(
                  `Content still too long, reducing to ${newMaxLength} characters...`
                );

                const moreTruncated = truncateContent(
                  rawRequest,
                  rawResponse,
                  newMaxLength
                );
                usedRequest = moreTruncated.request;
                usedResponse = moreTruncated.response;

                sdk.console.log(
                  `New truncated lengths: Request=${usedRequest.length}, Response=${usedResponse.length}`
                );

                prompt = createPrompt(usedRequest, usedResponse);
                sdk.console.log(`New prompt length: ${prompt.length}`);

                // Update the payload
                openaiPayload.messages[0].content = prompt;
                spec.setBody(JSON.stringify(openaiPayload));

                retryCount++;
                continue;
              } else {
                // For other API errors, simply retry with the same content
                retryCount++;
                if (retryCount < MAX_RETRIES) {
                  sdk.console.log(
                    `API error, retrying in ${
                      RETRY_DELAY / 1000
                    } seconds: ${errorMsg}`
                  );
                  await delay(RETRY_DELAY);
                  continue;
                } else {
                  throw new Error(`OpenAI API error: ${errorMsg}`);
                }
              }
            }

            // If we got here without errors, we can proceed with the response
            if (body && body.choices && body.choices.length > 0) {
              sdk.console.log(`Response has ${body.choices.length} choices`);
              break; // Exit the retry loop
            } else {
              sdk.console.log("Response has no choices array or it's empty");
              throw new Error("Unexpected response format");
            }
          } catch (error) {
            sdk.console.log(
              `Error in attempt ${retryCount + 1}: ${error.message}`
            );

            // Network/operational errors should be retried without changing content
            if (
              error.message.includes("Failed to send request") ||
              error.message.includes("OperationFailed") ||
              error.message.includes("timeout") ||
              error.message.includes("network") ||
              error.message.includes("connect")
            ) {
              retryCount++;
              if (retryCount < MAX_RETRIES) {
                sdk.console.log(
                  `Network error, retrying in ${RETRY_DELAY / 1000} seconds...`
                );
                await delay(RETRY_DELAY);
                continue;
              } else {
                throw new Error(
                  `Maximum retry attempts reached: ${error.message}`
                );
              }
            }

            // Token/length errors need content reduction
            else if (
              error.message.includes("string too long") ||
              error.message.includes("maximum length") ||
              error.message.includes("maximum context length") ||
              error.message.includes("reduce the length")
            ) {
              // Further reduce content size
              const newMaxLength = Math.floor(MAX_TOTAL_LENGTH / 2);
              sdk.console.log(
                `Content too long, reducing to ${newMaxLength} characters...`
              );

              const moreTruncated = truncateContent(
                rawRequest,
                rawResponse,
                newMaxLength
              );
              usedRequest = moreTruncated.request;
              usedResponse = moreTruncated.response;

              sdk.console.log(
                `New truncated lengths: Request=${usedRequest.length}, Response=${usedResponse.length}`
              );

              prompt = createPrompt(usedRequest, usedResponse);
              sdk.console.log(`New prompt length: ${prompt.length}`);

              // Update the payload
              openaiPayload.messages[0].content = prompt;
              spec.setBody(JSON.stringify(openaiPayload));

              retryCount++;

              if (retryCount < MAX_RETRIES) {
                continue;
              } else {
                throw new Error(
                  "Maximum retry attempts reached. Could not find a working content size."
                );
              }
            } else {
              // Other errors should not be retried
              throw error;
            }
          }
        }

        // If we got here and still have no valid body, throw an error
        if (!body || !body.choices || body.choices.length === 0) {
          throw new Error("Failed to get a valid response after attempts");
        }

        // Check if the message property exists in the first choice
        if (!body.choices[0].message) {
          sdk.console.log("Response missing message in first choice");
          // If there's a different property that contains the content, try to use that
          if (body.choices[0].text) {
            sdk.console.log("Found 'text' property instead of 'message'");
            const content = body.choices[0].text;
            await sdk.findings.create({
              title: "Pseudocode Analysis",
              description: content,
              severity: "medium",
              reporter: "OpenAI-Pseudocode-Analysis",
              request: request,
            });
            return;
          }

          await sdk.findings.create({
            title: "Pseudocode Analysis Error",
            description:
              "Failed to generate pseudocode analysis: Unexpected response format from OpenAI API (missing message)",
            severity: "low",
            reporter: "OpenAI-Pseudocode-Analysis",
            request: request,
          });
          return;
        }

        const content = body.choices[0].message.content;
        await sdk.findings.create({
          title: "Pseudocode Analysis",
          description: content,
          severity: "medium",
          reporter: "OpenAI-Pseudocode-Analysis",
          request: request,
        });
      } catch (innerError) {
        sdk.console.log(`Inner error: ${innerError.message}`);
        if (innerError.stack) {
          sdk.console.log(`Inner error stack: ${innerError.stack}`);
        }
        throw innerError;
      }
    } catch (middleError) {
      sdk.console.log(`Middle error: ${middleError.message}`);
      if (middleError.stack) {
        sdk.console.log(`Middle error stack: ${middleError.stack}`);
      }
      throw middleError;
    }
  } catch (error) {
    // Log the error and create a finding with the error information
    sdk.console.log(`Error in Pseudocode Analysis: ${error.message}`);
    if (error.stack) {
      sdk.console.log(`Error stack: ${error.stack}`);
    }

    try {
      await sdk.findings.create({
        title: "Pseudocode Analysis Error",
        description: `Failed to generate pseudocode analysis: ${error.message}`,
        severity: "low",
        reporter: "OpenAI-Pseudocode-Analysis",
        request: input && input.request ? input.request : null,
      });
    } catch (findingError) {
      sdk.console.log(`Error creating finding: ${findingError.message}`);
    }
  }
}
