"""Offline validation of package generation and narrowly scoped USB recovery."""
import unittest
from package_firmware import package_firmware
from recover_firmware import recovery_commands,validate
class Packages(unittest.TestCase):
 def app(self):
  data=bytearray(100000);data[0]=0xe9;data[12]=9;marker=b'CHROMA-STUDIO:T-EMBED-CC1101-PLUS:WEB1:0.5.0\0';data[500:500+len(marker)]=marker;return data
 def test_roundtrip(self):
  data=self.app();package,manifest=package_firmware(data,'0.5.0');self.assertEqual(package[:8],b'CHROMA5\n');self.assertEqual(manifest['bytes'],len(data));validate(data)
 def test_wrong_image(self):
  with self.assertRaises(ValueError):package_firmware(self.app(),'0.5.1')
  data=self.app();data[12]=0
  with self.assertRaises(ValueError):package_firmware(data,'0.5.0')
  with self.assertRaises(ValueError):validate(b'CHROMA5\n'+data)
 def test_recovery_addresses(self):
  commands=recovery_commands('COM12','firmware.bin');self.assertEqual(commands[0][-3:],['write_flash','0x10000','firmware.bin']);self.assertEqual(commands[1][-3:],['erase_region','0xe000','0x2000']);self.assertTrue(all('erase_flash' not in command for command in commands))
if __name__=='__main__':unittest.main()
