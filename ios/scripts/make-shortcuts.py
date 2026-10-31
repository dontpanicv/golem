#!/usr/bin/env python3
"""Writes the shortcuts that Settings offers, signed for anyone with this Mac's iCloud account, into a folder.

usage: make-shortcuts.py <bundle id> <team id> <folder>

Ask Golem takes a screenshot and dictates in the app on screen, then gives both and the clipboard to AskIntent.
Dictate to Golem runs DictateIntent, so Back Tap can choose it too. iOS imports only signed shortcuts, and only
`shortcuts sign` signs them, with Apple's server: so a folder that is already signed for this script is kept.
"""
import os
import plistlib
import subprocess
import sys
import tempfile
import uuid

bundle, team, folder = sys.argv[1:4]
names = ["Ask Golem", "Dictate to Golem"]
paths = [os.path.join(folder, f"{name}.shortcut") for name in names]
if all(os.path.exists(path) and os.path.getmtime(path) >= os.path.getmtime(__file__) for path in paths):
    sys.exit(0)


def new_id():
    return str(uuid.uuid4()).upper()


def output(uid, name):
    return {"Type": "ActionOutput", "OutputUUID": uid, "OutputName": name}


def text_of(uid, name):
    return {"WFSerializationType": "WFTextTokenString",
            "Value": {"string": "￼", "attachmentsByRange": {"{0, 1}": output(uid, name)}}}


def golem(intent, **parameters):
    descriptor = {"BundleIdentifier": bundle, "AppIntentIdentifier": intent, "Name": "Golem", "TeamIdentifier": team}
    return {"WFWorkflowActionIdentifier": f"{bundle}.{intent}",
            "WFWorkflowActionParameters": {"UUID": new_id(), "AppIntentDescriptor": descriptor, **parameters}}


def action(identifier, uid, **parameters):
    return {"WFWorkflowActionIdentifier": f"is.workflow.actions.{identifier}",
            "WFWorkflowActionParameters": {"UUID": uid, **parameters}}


def shortcut(actions, glyph):
    return {"WFWorkflowActions": actions, "WFWorkflowClientVersion": "2700.0.4",
            "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
            "WFWorkflowIcon": {"WFWorkflowIconGlyphNumber": glyph, "WFWorkflowIconStartColor": 463140863},
            "WFWorkflowHasOutputFallback": False, "WFWorkflowImportQuestions": [], "WFWorkflowTypes": [],
            "WFWorkflowInputContentItemClasses": [], "WFWorkflowOutputContentItemClasses": []}


screen, dictated, clipboard = new_id(), new_id(), new_id()
shortcuts = [
    shortcut([
        action("takescreenshot", screen),
        action("dictatetext", dictated, WFDictateTextStopListening="After Pause"),
        action("getclipboard", clipboard),
        golem("AskIntent", question=text_of(dictated, "Dictated Text"),
              screenshot={"WFSerializationType": "WFTextTokenAttachment", "Value": output(screen, "Screenshot")},
              clipboard=text_of(clipboard, "Clipboard")),
    ], 59511),
    shortcut([golem("DictateIntent")], 59448),
]
os.makedirs(folder, exist_ok=True)
with tempfile.TemporaryDirectory() as unsigned:
    for name, path, data in zip(names, paths, shortcuts):
        source = os.path.join(unsigned, f"{name}.shortcut")
        with open(source, "wb") as file:
            plistlib.dump(data, file, fmt=plistlib.FMT_BINARY)
        subprocess.run(["shortcuts", "sign", "--mode", "anyone", "--input", source, "--output", path], check=True)
        if not os.path.exists(path):
            sys.exit(f"shortcuts sign wrote no {name}.shortcut")
