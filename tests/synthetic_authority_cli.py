"""Process boundary for isolated synthetic authority tests only."""
import json
import sys
from backend.synthetic_scan_authority import SyntheticAuthority

command, path, *args = sys.argv[1:]
if command == 'provision':
    authority = SyntheticAuthority.provision(path)
    print(json.dumps(authority.marker))
else:
    authority = SyntheticAuthority(path, args[0])
    if command == 'acquire':
        print(json.dumps(authority.acquire(int(args[1]), args[2] if len(args)>2 else None)))
    elif command == 'release':
        print(json.dumps(authority.release_after_termination(args[1], int(args[2]), args[3] if len(args)>3 else None, None if len(args)<=4 or args[4]=='none' else args[4]=='true')))
    else:
        raise ValueError('Unknown synthetic test operation')
