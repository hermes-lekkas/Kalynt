# Publication drafts

These drafts describe the published 2.0 release. Add a measured demo only after recording one; do not imply that source-only improvements are in the downloadable installers.

## DEV article replacement

Title: Kalynt 2.0: an open-source AI IDE with local models and peer-to-peer collaboration

Kalynt is a desktop code editor for developers who want control over their AI workflow. It is open source under AGPL-3.0. There is no Kalynt subscription or account requirement.

Run a model on your own machine, or use your own key for a supported cloud provider. Local inference keeps AI requests on your machine; cloud mode sends request context directly to your chosen provider. The editor includes Git, a terminal, debugging, and an agent whose edits you can review and undo.

Peer-to-peer collaboration lets people share a workspace directly. Set a room password to enable end-to-end encryption. Network restrictions may affect connectivity, and peers need to be online to sync.

Try a small project first:

1. Install Kalynt and open a folder.
2. Add a cloud key or download and load a local model under Settings → Models and keys.
3. Ask: "Explain how this project starts. Point me to the entry file and the command to run it. Don't change any files."

Small models are better suited to explanations than complex agent tasks. Local model files require additional disk space and memory; speed depends on the hardware and model. External cloud providers bill their own API usage.

Earlier versions of this article described an open-core approach. The current repository is AGPL-3.0 licensed. See the source and license for the current implementation and terms.

Website: https://hermes-lekkas.github.io/Kalynt/
Releases: https://github.com/hermes-lekkas/Kalynt/releases/latest
Source: https://github.com/hermes-lekkas/Kalynt

If you try it, please share your OS, RAM, model, and the first point where you got stuck. Do not include API keys or private code.

## SaaSHub correction

Kalynt is actively maintained. Version 2.0.0 was released on October 19, 2026, and the website is reachable. Please remove the discontinued classification and update the product URL to https://hermes-lekkas.github.io/Kalynt/ .

Evidence: https://github.com/hermes-lekkas/Kalynt/releases/tag/v2.0.0
Source: https://github.com/hermes-lekkas/Kalynt

## Volunteer invitation

I'm looking for five developers who use local AI, or want to try it, to test Kalynt's first session. Kalynt is an AGPL-3.0 desktop IDE with local models, optional cloud API keys, and peer-to-peer collaboration.

The task is to install it, open a small project, and get one useful explanation. I'd like honest feedback about setup friction and what would make it useful in your existing workflow. You can keep your current editor. Please use code you are comfortable showing and keep credentials private.

Downloads and setup: https://hermes-lekkas.github.io/Kalynt/
Feedback: https://github.com/hermes-lekkas/Kalynt/discussions
