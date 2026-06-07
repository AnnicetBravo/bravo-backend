content = open('server.js').read()
content = content.replace(
    "const path     = require('path');",
    "const path     = require('path');\nconst fetch    = require('node-fetch');"
)
open('server.js', 'w').write(content)
print('Done')
