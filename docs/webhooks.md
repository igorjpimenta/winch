# Webhooks and wake bridge

Claim webhooks notify harnesses when work is claimed. Register via:

    winch webhook set --harness H --url U [--bearer B]
    winch webhook list
    winch webhook remove --harness H
    winch webhook test --harness H

The wake bridge receives the claim webhook and prompts the claiming session
through the OpenCode SDK. OpenClaw receives webhooks at POST /api/winch/claimed.
