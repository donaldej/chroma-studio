"""Embed the deployed UI in the application so OTA updates both atomically."""
from pathlib import Path
import gzip
Import('env')
root=Path(env.subst('$PROJECT_DIR'))
output=Path(env.subst('$BUILD_DIR'))/'generated'
output.mkdir(parents=True,exist_ok=True)
parts=['#pragma once\n#include <Arduino.h>\n']
for filename,symbol in [('index.htm','studio_index'),('app.js.gz','studio_js'),('app.css.gz','studio_css')]:
 data=(root/'data'/filename).read_bytes()
 if filename.endswith('.gz'):gzip.decompress(data)
 parts.append('static const uint8_t '+symbol+'[] PROGMEM = {\n'+','.join(str(byte) for byte in data)+'\n};\n')
header=output/'studio_web.h'
text=''.join(parts)
if not header.exists() or header.read_text()!=text:header.write_text(text)
env.Append(CPPPATH=[str(output)])
