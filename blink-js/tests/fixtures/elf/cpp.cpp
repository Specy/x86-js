#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
int main() {
  std::vector<std::string> words{"hello", "C++"};
  for (const auto &word : words) std::cout << word << '\n';
  try { throw std::runtime_error("caught exception"); }
  catch (const std::exception &error) { std::cout << error.what() << '\n'; }
}
