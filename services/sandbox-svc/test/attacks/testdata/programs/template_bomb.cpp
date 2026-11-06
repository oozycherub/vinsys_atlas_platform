template <int N> struct Bomb { static const int value = Bomb<N - 1>::value + Bomb<N - 2>::value; };
template <> struct Bomb<0> { static const int value = 0; };
template <> struct Bomb<1> { static const int value = 1; };
int main() { return Bomb<100000>::value; }
