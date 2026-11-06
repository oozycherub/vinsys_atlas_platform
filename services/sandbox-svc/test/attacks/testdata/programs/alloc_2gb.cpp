#include <cstdio>
#include <vector>
int main() { std::vector<char> v(2UL << 30, 1); std::printf("%zu\n", v.size()); }
