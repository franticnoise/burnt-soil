import unittest

from burnt_soil.terrain import Terrain


class TerrainTests(unittest.TestCase):
    def test_carve_circle_pushes_surface_downward(self) -> None:
        terrain = Terrain(200, 160, seed=4)
        before = terrain.heights[100]
        terrain.carve_circle((100, before + 12), 22)
        self.assertGreaterEqual(terrain.heights[100], before)

    def test_landing_pad_flattens_region(self) -> None:
        terrain = Terrain(200, 160, seed=12)
        terrain.make_landing_pad(90, 14)
        pad = terrain.heights[76:105]
        self.assertEqual(min(pad), max(pad))


if __name__ == "__main__":
    unittest.main()